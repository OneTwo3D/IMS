/**
 * THE OWNER LIFECYCLE REVIEW, as data: one row per product or variation any of the four systems holds (Qoblex, WooCommerce, the WMS, IMS as it will load),
 * joined by EXACT SKU only (never by name), with the SKU each system holds, the stock each reports, the lifecycle the first load would set, and the SKU
 * mismatch flags. The REVIEW SET is every row that is draft (or private or pending) in WooCommerce, or whose WooCommerce PARENT is (a published variation under a
 * draft parent is not on sale either), Archived in Qoblex, or discontinued in the WMS.
 *
 * STOCK. A row holds stock when ANY single figure is above zero: one Qoblex warehouse (never the sum: +5 in one warehouse and -5 in another is stock), the
 * WooCommerce quantity or the WMS physical stock. A VARIABLE parent holds no stock of its own in Qoblex or the WMS: it shows the SUM of its variations' figures
 * and holds stock when ANY of its variations does (or its own WooCommerce figure is above zero); the generation record keeps each variation's figures, so an
 * Archived decision on the parent is checked against every one of them.
 *
 * PURE: no file, no clock, no request. lib/first-load/lifecycle-review/cli.ts gathers the inputs, sheet.ts renders the rows.
 *
 * HOW ROWS ARE JOINED. A row is anchored on the SKU IMS will load (the catalogue entry, after sku-renames), or for a Qoblex product the run does not load, on
 * the SKU it would load under. WooCommerce and the WMS are matched to that SKU exactly; when they do not hold it but hold the Qoblex spelling of a renamed SKU,
 * they are matched to that and flagged (the rename still needs fixing there). Whatever WooCommerce or the WMS holds that matched no row is a row of its own.
 * A SKU that differs only in letter case or whitespace from one another system holds is NEVER joined to it: it is flagged on both rows.
 */
import { D, fmt, parseDecimal, type Dec } from '../money'
import { NUMERIC_LIMITS } from '../spec'
import type { SnapshotPayload } from '../snapshot'
import type { CatalogueEntry } from '../transform'
import { parseSku, skuKey } from '../validate'
import type { ReviewEntry, StockFigure } from './generation'

/** The WMS product and stock listing, as the connector read it (GET only). SKUs are exactly as the WMS holds them (not trimmed). */
export interface WmsListing {
  products: Array<{ sku: string; productId: string; status: 'active' | 'discontinued' | 'not stated' }>
  /** Physical on-hand per SKU, summed over the warehouses read (exact SKU as the stock list gives it). */
  physical: ReadonlyMap<string, number>
  /** The warehouse ids read. */
  warehouses: string[]
}

export interface QoblexProductRow {
  /** The SKU cell as Qoblex holds it (not trimmed). */
  sku: string
  name: string
  type: string
  /** Qoblex "State" as the export states it (Active, Inactive, Archived), or the canonical lifecycle cell. */
  state: string
}

export interface QoblexStockRow {
  sku: string
  warehouseCode: string
  qty: string
}

export interface ReviewInputs {
  catalogue: readonly CatalogueEntry[]
  skuRenames: ReadonlyArray<{ from: string; to: string }>
  qoblexProducts: readonly QoblexProductRow[]
  qoblexStock: readonly QoblexStockRow[]
  snapshot: SnapshotPayload
  /** null: the WMS listing was not read. */
  wms: WmsListing | null
}

export type FlagKind = 'MISSING' | 'RENAMED' | 'CASE_OR_WHITESPACE'
export interface SkuFlag {
  kind: FlagKind
  detail: string
}

export type SystemName = 'Qoblex' | 'WooCommerce' | 'WMS' | 'IMS'

export interface ReviewRow {
  /** The SKU IMS will load, or null when the first load does not load the product. */
  imsSku: string | null
  /** The SKU the row is joined on (the IMS SKU, or what a not-loaded Qoblex product would load as, or the other system's own SKU). */
  matchSku: string
  qoblexSku: string | null
  wooSku: string | null
  wooId: number | null
  wmsSku: string | null
  wmsId: string | null
  name: string
  nameSource: 'WooCommerce' | 'Qoblex (not in WooCommerce)' | ''
  type: string
  parentSku: string
  qoblexState: string
  wooStatus: string
  wooParentStatus: string
  wmsStatus: string
  /** Total and per warehouse code; null when Qoblex does not hold the product. */
  qoblexStock: { total: string; byWarehouse: Record<string, string> } | null
  wooStock: StockFigure
  wmsStock: StockFigure
  /** The lifecycle the first load would set (before any owner decision), or null when the product is not loaded. */
  lifecycle: string | null
  flags: SkuFlag[]
  /** Why the row is in the review set (empty: not in it). */
  reviewReasons: string[]
  stockAboveZero: boolean
}

/** The model cannot be built from these inputs (a SKU that is both a WooCommerce product and a variation: they would overwrite each other). */
export class ReviewModelError extends Error {}

export interface ReviewModel {
  rows: ReviewRow[]
  review: ReviewRow[]
  /** Every Qoblex warehouse code that appears in the stock file, sorted. */
  warehouses: string[]
  /** The review-set rows that IMS loads: the ones the owner decides (the generation record's review set). */
  entries: ReviewEntry[]
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** The comparison form for the case/whitespace check only (never for a join): NFC, every whitespace removed, upper case. */
export function looseSku(sku: string): string {
  return sku.normalize('NFC').replace(/\s+/gu, '').toUpperCase()
}

const positive = (f: StockFigure): boolean => f.kind === 'qty' && new D(f.qty).gt(0)
/** Any single Qoblex warehouse above zero (MED-2: never the sum). */
const anyWarehousePositive = (byWarehouse: Readonly<Record<string, string>>): boolean => Object.values(byWarehouse).some((qty) => new D(qty).gt(0))

/** A WooCommerce stock figure from the snapshot: a managed product (or variation) with a quantity, not managed, or managed without a readable quantity. */
function wooFigure(manageStock: boolean | 'parent', stockQuantity: number | null): StockFigure {
  if (manageStock === false) return { kind: 'unmanaged' }
  return stockQuantity === null ? { kind: 'unknown' } : { kind: 'qty', qty: String(stockQuantity) }
}

/** The display figure of a VARIABLE parent: not read when any part was not read, else the sum of the quantities, else not managed / not held. */
function aggregate(figures: readonly StockFigure[]): StockFigure {
  if (figures.some((f) => f.kind === 'unknown')) return { kind: 'unknown' }
  const qtys = figures.filter((f): f is { kind: 'qty'; qty: string } => f.kind === 'qty')
  if (qtys.length > 0) return { kind: 'qty', qty: fmt(qtys.reduce((a, f) => a.add(new D(f.qty)), new D(0))) }
  return figures.some((f) => f.kind === 'unmanaged') ? { kind: 'unmanaged' } : { kind: 'absent' }
}

interface WooRecord { sku: string; id: number; name: string; type: string; status: string; parentStatus: string; parentSku: string; stock: StockFigure }

export function buildReviewModel(input: ReviewInputs): ReviewModel {
  // ---- the renames and the Qoblex side, keyed by the SKU IMS loads ----
  const renameTo = new Map(input.skuRenames.map((r) => [skuKey(r.from), r.to]))
  const imsSkuOf = (raw: string): string | null => {
    const parsed = parseSku(raw)
    if (!parsed.ok) return null
    return renameTo.get(parsed.key) ?? parsed.sku
  }
  const qoblex = new Map<string, QoblexProductRow & { ims: string }>()
  for (const row of input.qoblexProducts) {
    const ims = imsSkuOf(row.sku)
    if (ims === null) continue
    qoblex.set(skuKey(ims), { ...row, ims })
  }
  const stock = new Map<string, Map<string, Dec>>()
  const warehouses = new Set<string>()
  for (const row of input.qoblexStock) {
    const ims = imsSkuOf(row.sku)
    const qty = parseDecimal(row.qty, 'qty', NUMERIC_LIMITS.stockQty, { allowNegative: true })
    if (ims === null || !qty.ok) continue
    const code = row.warehouseCode.trim().toUpperCase()
    warehouses.add(code)
    const per = stock.get(skuKey(ims)) ?? new Map<string, Dec>()
    per.set(code, (per.get(code) ?? new D(0)).add(qty.value))
    stock.set(skuKey(ims), per)
  }

  // ---- WooCommerce: every product and variation with a SKU, by exact SKU ----
  const woo = new Map<string, WooRecord>()
  const parents = new Map(input.snapshot.parents.map((p) => [p.id, p]))
  // L11: a SKU held twice (a product and a variation, or two of either) would silently overwrite one record with the other. The verified snapshot already
  // refuses that (snapshotProblems); the model refuses it too rather than pick one.
  const putWoo = (rec: WooRecord) => {
    if (woo.has(rec.sku)) throw new ReviewModelError(`WooCommerce holds the SKU ${JSON.stringify(rec.sku.slice(0, 60))} twice (ids ${woo.get(rec.sku)!.id} and ${rec.id}): the review cannot tell which one a row is`)
    woo.set(rec.sku, rec)
  }
  for (const p of input.snapshot.products) {
    if (p.sku === '') continue
    putWoo({ sku: p.sku, id: p.id, name: p.name, type: p.type, status: p.status, parentStatus: '', parentSku: '', stock: wooFigure(p.manageStock, p.stockQuantity) })
  }
  for (const v of input.snapshot.variations) {
    if (v.sku === '') continue
    const parent = parents.get(v.parentId)
    const options = v.attributes.map((a) => a.option).filter((o) => o !== '')
    putWoo({
      sku: v.sku, id: v.id, name: `${parent?.name ?? ''}${options.length > 0 ? ` - ${options.join(', ')}` : ''}`, type: 'variation', status: v.status,
      parentStatus: parent?.status ?? '', parentSku: parent?.sku ?? '',
      // MED-5: the variation's own stock from the snapshot's variation walk (`parent`: it draws on the parent's stock, which the store reports as its own).
      stock: wooFigure(v.manageStock, v.stockQuantity),
    })
  }
  // ---- the WMS ----
  const wms = new Map<string, WmsListing['products'][number]>()
  if (input.wms) for (const p of input.wms.products) wms.set(p.sku, p)

  // ---- rows anchored on IMS (and on Qoblex products the run does not load) ----
  const cat = new Map(input.catalogue.map((e) => [skuKey(e.sku), e]))
  const rows: ReviewRow[] = []
  const usedWoo = new Set<string>()
  const usedWms = new Set<string>()
  const viaOld = new Map<ReviewRow, { woo: boolean; wms: boolean }>()
  const anchors: Array<{ key: string; entry: CatalogueEntry | null; q: (QoblexProductRow & { ims: string }) | null }> = []
  for (const [key, entry] of cat) anchors.push({ key, entry, q: qoblex.get(key) ?? null })
  for (const [key, q] of qoblex) if (!cat.has(key)) anchors.push({ key, entry: null, q })
  for (const { key, entry, q } of anchors) {
    const matchSku = entry?.sku ?? q!.ims
    const qSku = q?.sku ?? null
    let wooRec = woo.get(matchSku)
    let wooViaOld = false
    if (!wooRec && qSku !== null && qSku !== matchSku && woo.has(qSku)) { wooRec = woo.get(qSku); wooViaOld = true }
    if (wooRec) usedWoo.add(wooRec.sku)
    let wmsRec = wms.get(matchSku)
    let wmsViaOld = false
    if (!wmsRec && qSku !== null && qSku !== matchSku && wms.has(qSku)) { wmsRec = wms.get(qSku); wmsViaOld = true }
    if (wmsRec) usedWms.add(wmsRec.sku)
    const per = stock.get(key)
    const qoblexStock = q === null ? null : {
      total: fmt([...(per?.values() ?? [])].reduce((a, b) => a.add(b), new D(0))),
      byWarehouse: Object.fromEntries([...(per?.entries() ?? [])].map(([code, qty]) => [code, fmt(qty)])),
    }
    const row: ReviewRow = {
      imsSku: entry?.sku ?? null,
      matchSku,
      qoblexSku: qSku,
      wooSku: wooRec?.sku ?? null,
      wooId: wooRec?.id ?? null,
      wmsSku: wmsRec?.sku ?? null,
      wmsId: wmsRec?.productId ?? null,
      name: wooRec ? wooRec.name : q?.name ?? entry?.name ?? '',
      nameSource: wooRec ? 'WooCommerce' : q || entry ? 'Qoblex (not in WooCommerce)' : '',
      type: entry?.type ?? q?.type ?? '',
      parentSku: entry?.parentSku ?? wooRec?.parentSku ?? '',
      qoblexState: q?.state ?? '',
      wooStatus: wooRec?.status ?? '',
      wooParentStatus: wooRec?.parentStatus ?? '',
      wmsStatus: input.wms === null ? 'not read' : wmsRec?.status ?? '',
      qoblexStock,
      wooStock: wooRec ? wooRec.stock : { kind: 'absent' },
      wmsStock: wmsFigure(input.wms, wmsRec?.sku ?? null),
      lifecycle: entry?.lifecycle ?? null,
      flags: [],
      reviewReasons: [],
      stockAboveZero: false,
    }
    rows.push(row)
    if (wooViaOld || wmsViaOld) viaOld.set(row, { woo: wooViaOld, wms: wmsViaOld })
  }
  // ---- what WooCommerce or the WMS holds that no row took ----
  for (const rec of woo.values()) {
    if (usedWoo.has(rec.sku)) continue
    const wmsRec = wms.get(rec.sku)
    if (wmsRec) usedWms.add(wmsRec.sku)
    rows.push(blankRow(rec.sku, {
      wooSku: rec.sku, wooId: rec.id, name: rec.name, nameSource: 'WooCommerce', type: rec.type, parentSku: rec.parentSku, wooStatus: rec.status, wooParentStatus: rec.parentStatus, wooStock: rec.stock,
      wmsSku: wmsRec?.sku ?? null, wmsId: wmsRec?.productId ?? null, wmsStatus: input.wms === null ? 'not read' : wmsRec?.status ?? '', wmsStock: wmsFigure(input.wms, wmsRec?.sku ?? null),
    }))
  }
  for (const rec of wms.values()) {
    if (usedWms.has(rec.sku)) continue
    rows.push(blankRow(rec.sku, { wmsSku: rec.sku, wmsId: rec.productId, wmsStatus: rec.status, wmsStock: wmsFigure(input.wms, rec.sku) }))
  }

  // ---- flags ----
  const loose: Record<SystemName, Map<string, Set<string>>> = { Qoblex: new Map(), WooCommerce: new Map(), WMS: new Map(), IMS: new Map() }
  const index = (system: SystemName, sku: string) => {
    const k = looseSku(sku)
    loose[system].set(k, (loose[system].get(k) ?? new Set()).add(sku))
  }
  for (const q of input.qoblexProducts) if (q.sku.trim() !== '') index('Qoblex', q.sku)
  for (const sku of woo.keys()) index('WooCommerce', sku)
  for (const sku of wms.keys()) index('WMS', sku)
  for (const e of input.catalogue) index('IMS', e.sku)
  for (const row of rows) {
    const via = viaOld.get(row)
    const variable = row.type === 'VARIABLE' || row.type === 'variable'
    const nonStock = row.type === 'NON_INVENTORY'
    const held: Record<SystemName, string | null> = { Qoblex: row.qoblexSku, WooCommerce: row.wooSku, WMS: row.wmsSku, IMS: row.imsSku }
    const expected: Record<SystemName, boolean> = {
      // A VARIABLE parent is a WooCommerce construct that IMS loads from the variant-parents join: Qoblex and the WMS hold no such product.
      Qoblex: !variable,
      WooCommerce: true,
      WMS: input.wms !== null && !variable && !nonStock,
      IMS: true,
    }
    for (const system of ['Qoblex', 'WooCommerce', 'WMS', 'IMS'] as const) {
      if (held[system] !== null || !expected[system]) continue
      const near = [...(loose[system].get(looseSku(row.matchSku)) ?? [])].filter((s) => s !== row.matchSku)
      if (near.length > 0) row.flags.push({ kind: 'CASE_OR_WHITESPACE', detail: `${system} holds ${near.map((s) => JSON.stringify(s)).join(', ')}, which differs from ${JSON.stringify(row.matchSku)} only in letter case or whitespace (never joined)` })
      else row.flags.push({ kind: 'MISSING', detail: system === 'IMS' ? 'not loaded into IMS' : `not in ${system}` })
    }
    if (row.qoblexSku !== null && row.qoblexSku !== row.matchSku) {
      // IMS loads the trimmed, NFC form of a Qoblex SKU (or its rename): outer whitespace is the only other way the two can differ.
      if (!renameTo.has(skuKey(row.qoblexSku.normalize('NFC').trim()))) row.flags.push({ kind: 'CASE_OR_WHITESPACE', detail: `Qoblex holds ${JSON.stringify(row.qoblexSku)} (outer whitespace or a different Unicode form); IMS loads ${JSON.stringify(row.matchSku)}` })
      else row.flags.push({ kind: 'RENAMED', detail: `Qoblex holds ${JSON.stringify(row.qoblexSku)}; IMS loads it as ${JSON.stringify(row.matchSku)} (sku-renames): fix the SKU in Qoblex if it is kept` })
    }
    if (via?.woo) row.flags.push({ kind: 'RENAMED', detail: `WooCommerce still holds the pre-rename SKU ${JSON.stringify(row.wooSku)}` })
    if (via?.wms) row.flags.push({ kind: 'RENAMED', detail: `WMS still holds the pre-rename SKU ${JSON.stringify(row.wmsSku)}: fix it there` })

    // ---- the review set ----
    if (row.wooSku !== null && row.wooStatus !== 'publish') row.reviewReasons.push(`WooCommerce ${row.wooStatus}`)
    // L10: a published variation under a draft (private, pending) parent is not on sale either.
    if (row.wooSku !== null && row.wooParentStatus !== '' && row.wooParentStatus !== 'publish') row.reviewReasons.push(`WooCommerce parent ${row.wooParentStatus}`)
    if (row.qoblexState.trim().toLowerCase() === 'archived') row.reviewReasons.push('Qoblex Archived')
    if (row.wmsStatus === 'discontinued') row.reviewReasons.push('WMS discontinued')
    row.stockAboveZero = (row.qoblexStock !== null && anyWarehousePositive(row.qoblexStock.byWarehouse)) || positive(row.wooStock) || positive(row.wmsStock)
  }

  // ---- a VARIABLE parent: its variations' stock (MED-3) ----
  const childrenOf = new Map<string, ReviewRow[]>()
  for (const row of rows) {
    if (row.imsSku === null) continue
    const entry = cat.get(skuKey(row.imsSku))
    if (!entry || entry.parentSku === '') continue
    const key = skuKey(entry.parentSku)
    childrenOf.set(key, [...(childrenOf.get(key) ?? []), row])
  }
  const variationsOf = new Map<ReviewRow, ReviewRow[]>()
  for (const row of rows) {
    if (row.imsSku === null || cat.get(skuKey(row.imsSku))?.type !== 'VARIABLE') continue
    const children = (childrenOf.get(skuKey(row.imsSku)) ?? []).sort((a, b) => cmp(a.matchSku, b.matchSku))
    variationsOf.set(row, children)
    if (children.length === 0) continue
    const byWarehouse = new Map<string, Dec>()
    for (const child of children) for (const [code, qty] of Object.entries(child.qoblexStock?.byWarehouse ?? {})) byWarehouse.set(code, (byWarehouse.get(code) ?? new D(0)).add(new D(qty)))
    if (children.some((c) => c.qoblexStock !== null)) {
      row.qoblexStock = { total: fmt([...byWarehouse.values()].reduce((a, b) => a.add(b), new D(0))), byWarehouse: Object.fromEntries([...byWarehouse.entries()].map(([code, qty]) => [code, fmt(qty)])) }
    }
    const own = row.wooStock
    row.wooStock = aggregate([...(own.kind === 'absent' ? [] : [own]), ...children.map((c) => c.wooStock)])
    row.wmsStock = aggregate(children.map((c) => c.wmsStock))
    // Highlighted when ANY variation holds stock (never the sum), or the parent's own WooCommerce figure does.
    row.stockAboveZero = positive(own) || children.some((c) => c.stockAboveZero)
  }
  rows.sort((a, b) => cmp(a.matchSku, b.matchSku) || cmp(a.wooSku ?? '', b.wooSku ?? '') || cmp(a.wmsSku ?? '', b.wmsSku ?? ''))
  const review = rows.filter((r) => r.reviewReasons.length > 0)
  const entries: ReviewEntry[] = review.filter((r) => r.imsSku !== null).map((r): ReviewEntry => {
    const variations = variationsOf.get(r)
    return {
      sku: r.imsSku!, proposed: r.lifecycle ?? '', reasons: [...r.reviewReasons],
      qoblexStock: r.qoblexStock?.total ?? '0', qoblexByWarehouse: { ...(r.qoblexStock?.byWarehouse ?? {}) }, wooStock: r.wooStock, wmsStock: r.wmsStock,
      ...(variations === undefined ? {} : { variations: variations.map((c) => ({ sku: c.imsSku!, qoblexByWarehouse: { ...(c.qoblexStock?.byWarehouse ?? {}) }, wooStock: c.wooStock, wmsStock: c.wmsStock })) }),
    }
  })
  return { rows, review, warehouses: [...warehouses].sort(cmp), entries }
}

function wmsFigure(listing: WmsListing | null, sku: string | null): StockFigure {
  if (listing === null) return { kind: 'unknown' }
  if (sku === null) return { kind: 'absent' }
  const qty = listing.physical.get(sku)
  return { kind: 'qty', qty: String(qty ?? 0) }
}

function blankRow(matchSku: string, fill: Partial<ReviewRow>): ReviewRow {
  return {
    imsSku: null, matchSku, qoblexSku: null, wooSku: null, wooId: null, wmsSku: null, wmsId: null, name: '', nameSource: '', type: '', parentSku: '',
    qoblexState: '', wooStatus: '', wooParentStatus: '', wmsStatus: '', qoblexStock: null, wooStock: { kind: 'absent' }, wmsStock: { kind: 'absent' },
    lifecycle: null, flags: [], reviewReasons: [], stockAboveZero: false, ...fill,
  }
}
