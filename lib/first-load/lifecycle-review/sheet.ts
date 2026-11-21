/**
 * THE OWNER LIFECYCLE REVIEW SHEET: the review model rendered as an .xlsx workbook.
 *
 * Tabs: "Review" (the review set, with the two decision columns), "All products" (every row, for the SKU mapping check), "SKU mismatches" (one line per
 * flag), "Notes" (how to fill it in, what was and was not read), and a HIDDEN "_binding" tab (the sheet id and the generation digest the read-back
 * checks). Every text cell is an inline string and no cell is a formula (xlsx.ts); a row holding stock anywhere is filled yellow, the SKU cells of a
 * row with a SKU mismatch orange. The "New IMS status" column carries a drop-down restricted to the four owner statuses.
 *
 * PURE. Product data only: SKUs, names, statuses, stock figures and lifecycles; no customer, supplier contact or credential.
 */
import {
  ALL_PRODUCTS_TAB, BINDING_TAB, DECISION_HEADERS, LIFECYCLE_DECISION_STATUSES, MISMATCH_TAB, NOTES_TAB, REVIEW_TAB, describeFigure,
  type GenerationFile, type LifecycleDecisionLabel, type StockFigure,
} from './generation'
import type { ReviewModel, ReviewRow } from './model'
import { columnLetter, writeXlsx, type XCell, type XSheet } from './xlsx'

export interface SheetOptions {
  /** The WMS as the operator knows it (the script passes the connector's name), used in column headers. */
  wmsLabel: string
  /** Whether the WMS listing was read. When not, its columns read "not read" and the Notes say an Archived decision cannot be cleared by it. */
  wmsRead: boolean
  /** The WMS warehouses whose stock was read. */
  wmsWarehouses: readonly string[]
}

const LABEL_OF: Record<string, string> = Object.fromEntries(Object.entries(LIFECYCLE_DECISION_STATUSES).map(([label, code]) => [code, label]))
const lifecycleText = (code: string | null): string => (code === null ? 'not loaded' : `${code}${LABEL_OF[code] ? ` (${LABEL_OF[code]})` : ''}`)

function figureCell(f: StockFigure, fill: XCell['fill']): XCell {
  return f.kind === 'qty' ? { v: Number(f.qty), fill } : { v: describeFigure(f), fill }
}

interface Column {
  header: string
  width: number
  cell: (row: ReviewRow, fill: XCell['fill'], skuFill: XCell['fill']) => XCell
}

/** The model speaks of "WMS" (lib/first-load names no connector); the owner reads the system's own name. */
const named = (text: string, options: SheetOptions): string => text.replace(/\bWMS\b/g, options.wmsLabel)

function columns(model: ReviewModel, options: SheetOptions, review: boolean, sheetId: string): Column[] {
  const w = options.wmsLabel
  const text = (v: string | number | null) => (fill: XCell['fill']): XCell => ({ v, fill })
  const cols: Column[] = [
    { header: DECISION_HEADERS.sku, width: 22, cell: (r, _f, sf) => ({ v: r.imsSku ?? '', fill: sf }) },
    { header: 'Name', width: 48, cell: (r, f) => text(r.name)(f) },
    { header: 'Name source', width: 22, cell: (r, f) => text(r.nameSource)(f) },
    { header: 'IMS lifecycle the first load would set', width: 26, cell: (r, f) => text(lifecycleText(r.lifecycle))(f) },
  ]
  if (review) {
    cols.push(
      { header: DECISION_HEADERS.status, width: 18, cell: (r, f) => ({ v: '', fill: r.imsSku === null ? 'muted' : f ?? 'input' }) },
      { header: DECISION_HEADERS.reason, width: 36, cell: (r, f) => ({ v: '', fill: r.imsSku === null ? 'muted' : f ?? 'input' }) },
      { header: 'Why in review', width: 30, cell: (r, f) => text(named(`${r.reviewReasons.join('; ')}${r.imsSku === null ? ' (not loaded into IMS: no decision possible)' : ''}`, options))(f) },
    )
  }
  cols.push(
    { header: 'Stock > 0', width: 10, cell: (r, f) => text(r.stockAboveZero ? 'yes' : '')(f) },
    { header: 'SKU check', width: 48, cell: (r, f, sf) => ({ v: named(r.flags.map((flag) => flag.detail).join('; '), options), fill: r.flags.length > 0 ? sf : f }) },
    { header: 'Type', width: 14, cell: (r, f) => text(r.type)(f) },
    { header: 'Parent SKU', width: 18, cell: (r, f) => text(r.parentSku)(f) },
    { header: 'Qoblex SKU', width: 22, cell: (r, _f, sf) => ({ v: r.qoblexSku ?? '', fill: sf }) },
    { header: 'Woo SKU', width: 22, cell: (r, _f, sf) => ({ v: r.wooSku ?? '', fill: sf }) },
    { header: 'Woo id', width: 10, cell: (r, f) => text(r.wooId)(f) },
    { header: `${w} SKU`, width: 22, cell: (r, _f, sf) => ({ v: options.wmsRead ? r.wmsSku ?? '' : 'not read', fill: sf }) },
    { header: `${w} product id`, width: 14, cell: (r, f) => text(options.wmsRead ? r.wmsId ?? '' : 'not read')(f) },
    { header: 'Qoblex state', width: 14, cell: (r, f) => text(r.qoblexState)(f) },
    { header: 'Woo status', width: 12, cell: (r, f) => text(r.wooStatus)(f) },
    { header: 'Woo parent status', width: 16, cell: (r, f) => text(r.wooParentStatus)(f) },
    { header: `${w} status`, width: 14, cell: (r, f) => text(r.wmsStatus)(f) },
    { header: 'Qoblex stock total', width: 12, cell: (r, f) => (r.qoblexStock === null ? { v: 'not held', fill: f } : { v: Number(r.qoblexStock.total), fill: f }) },
    ...model.warehouses.map((code): Column => ({
      header: `Qoblex stock ${code}`, width: 12,
      cell: (r, f) => (r.qoblexStock === null ? { v: '', fill: f } : { v: Number(r.qoblexStock.byWarehouse[code] ?? '0'), fill: f }),
    })),
    { header: 'Woo stock', width: 12, cell: (r, f) => figureCell(r.wooStock, f) },
    { header: `${w} physical stock`, width: 14, cell: (r, f) => figureCell(r.wmsStock, f) },
  )
  // The sheet id on every decidable Review row: what binds a CSV export of the tab to this sheet. Blank on a row that cannot be decided, so that row reads back as blank.
  if (review) cols.push({ header: DECISION_HEADERS.sheetId, width: 22, cell: (r) => ({ v: r.imsSku === null ? '' : sheetId, fill: 'muted' }) })
  return cols
}

function grid(model: ReviewModel, rows: readonly ReviewRow[], options: SheetOptions, review: boolean, sheetId: string): { sheet: Omit<XSheet, 'name'>; statusColumn: number } {
  const cols = columns(model, options, review, sheetId)
  const header: XCell[] = cols.map((c) => ({ v: c.header, fill: 'header', bold: true }))
  const body = rows.map((row) => {
    const fill: XCell['fill'] = row.stockAboveZero ? 'stock' : undefined
    const skuFill: XCell['fill'] = row.flags.length > 0 ? 'mismatch' : fill
    return cols.map((c) => c.cell(row, fill, skuFill))
  })
  const statusColumn = cols.findIndex((c) => c.header === DECISION_HEADERS.status)
  return { sheet: { rows: [header, ...body], widths: cols.map((c) => c.width), freeze: { columns: 2 }, autoFilter: true }, statusColumn }
}

export function renderReviewSheet(model: ReviewModel, generation: GenerationFile, options: SheetOptions, notes: readonly string[]): Buffer {
  const review = grid(model, model.review, options, true, generation.sheetId)
  const statusLetter = columnLetter(review.statusColumn)
  const labels = Object.keys(LIFECYCLE_DECISION_STATUSES) as LifecycleDecisionLabel[]
  const reviewSheet: XSheet = {
    name: REVIEW_TAB,
    ...review.sheet,
    validations: model.review.length === 0 ? [] : [{
      range: `${statusLetter}2:${statusLetter}${model.review.length + 1}`,
      list: labels,
      errorTitle: 'Not an IMS status',
      error: `Pick one of: ${labels.join(', ')}.`,
    }],
  }
  const all: XSheet = { name: ALL_PRODUCTS_TAB, ...grid(model, model.rows, options, false, generation.sheetId).sheet }
  const flagged = model.rows.flatMap((row) => row.flags.map((flag) => [row, flag] as const))
  const mismatches: XSheet = {
    name: MISMATCH_TAB,
    rows: [
      ['IMS SKU', 'Qoblex SKU', 'Woo SKU', `${options.wmsLabel} SKU`, 'Check', 'Detail'].map((v): XCell => ({ v, fill: 'header', bold: true })),
      ...flagged.map(([row, flag]): XCell[] => [row.imsSku ?? '', row.qoblexSku ?? '', row.wooSku ?? '', options.wmsRead ? row.wmsSku ?? '' : 'not read', flag.kind, named(flag.detail, options)].map((v) => ({ v }))),
    ],
    widths: [22, 22, 22, 22, 20, 80],
    freeze: { columns: 1 },
    autoFilter: true,
  }
  const notesSheet: XSheet = { name: NOTES_TAB, rows: notes.map((line, i): XCell[] => [{ v: line, bold: i === 0 }]), widths: [140] }
  const binding: XSheet = {
    name: BINDING_TAB,
    state: 'hidden',
    rows: [
      [{ v: 'sheetId' }, { v: generation.sheetId }],
      [{ v: 'generationDigest' }, { v: generation.digest }],
      [{ v: 'formatVersion' }, { v: generation.formatVersion }],
      [{ v: 'note' }, { v: 'Do not edit or delete this tab: it binds the sheet to lifecycle-review.generation.json, and first-load:prepare refuses the decisions without it.' }],
    ],
  }
  return writeXlsx([reviewSheet, all, mismatches, notesSheet, binding])
}

/** The Notes tab: how to fill the sheet in, and everything that was and was not read. */
export function notesFor(model: ReviewModel, generation: GenerationFile, options: SheetOptions): string[] {
  const w = options.wmsLabel
  const labels = Object.entries(LIFECYCLE_DECISION_STATUSES).map(([label, code]) => `${label} = ${code}`).join('; ')
  const decidable = model.review.filter((r) => r.imsSku !== null).length
  const lines = [
    `Owner lifecycle review, sheet ${generation.sheetId}`,
    '',
    `The Review tab lists ${model.review.length} product(s) and variation(s) that are draft, private or pending in WooCommerce, Archived in Qoblex, or discontinued in ${w}. ${decidable} of them are loaded into IMS and need a decision.`,
    `Pick a "${DECISION_HEADERS.status}" for EACH of them: ${labels}. Discontinued can be sold but not ordered; Archived can be neither; Do not sell yet can be ordered but not sold; Active is both.`,
    'Your decision wins over the WooCommerce status and the Qoblex state. A row you leave blank BLOCKS the real first load until it is decided.',
    `Archived is refused for a product that holds stock in Qoblex, WooCommerce or ${w} (yellow rows, "Stock > 0"), or whose stock was not read, unless you write an "${DECISION_HEADERS.reason}" on that row; the reason is then reported.`,
    'Rows marked "not loaded into IMS" cannot be decided (IMS will not hold the product): leave their status blank.',
    `Do not edit the SKU columns or the "${DECISION_HEADERS.sheetId}" column, and do not delete the hidden tab: they tie your decisions to this sheet. You may sort, filter and widen columns. Save as .xlsx, or export the Review tab as CSV UTF-8.`,
    '',
    'SKU check (orange cells, and the SKU mismatches tab): SKUs are matched EXACTLY across Qoblex, WooCommerce, ' + `${w} and IMS (as it will load, after the agreed SKU renames), never by name. A flag says a system lacks the SKU, still holds a pre-rename SKU, or holds one that differs only in letter case or whitespace. VARIABLE parents exist only in WooCommerce and IMS; non-inventory products are not expected in ${w}.`,
    '',
    'What was read:',
    `- Qoblex: the stock-on-hand export named by the run manifest (state, stock total and per warehouse ${model.warehouses.join(', ') || '(none)'}).`,
    '- WooCommerce: the verified snapshot (each product\'s own status, a variation\'s parent status, the Woo stock quantity and title). The Woo stock is a point-in-time read. The snapshot carries NO stock figure for a variation: its Woo stock reads "not read", so an Archived variation needs an override reason unless that is fixed.',
    options.wmsRead
      ? `- ${w}: the product list (the status is its discontinued flag) and the physical stock of warehouse(s) ${options.wmsWarehouses.join(', ')}, summed, read with GET requests only.`
      : `- ${w}: NOT READ. Its columns read "not read", and an Archived decision cannot be cleared by its stock: every Archived row needs an override reason, or generate the sheet again with the ${w} listing.`,
    '- Names: the WooCommerce title (a variation: its parent title and attribute values). A product WooCommerce does not hold shows its Qoblex name, marked in "Name source".',
    '- "IMS lifecycle the first load would set" is the lifecycle before any decision (Qoblex state, then the WooCommerce status, which wins).',
    '',
    `Generation digest ${generation.digest}`,
  ]
  return lines
}
