/**
 * READING THE OWNER'S DECISIONS BACK from the filled lifecycle review sheet, or from a CSV export of its Review tab, into the canonical
 * lifecycle-decisions dataset (sku, status, reason, sheetId), plus what the file says about which sheet it is.
 *
 * PURE: bytes in, text out. Three shapes are read, recognised by content, never by file name:
 *   - the .xlsx itself (a ZIP): the Review tab is found by name and its columns by header text ("IMS SKU", "New IMS status", "Override reason",
 *     "Sheet id"), so the owner may sort, filter or widen columns; the hidden binding tab gives the sheet id and the generation digest;
 *   - a CSV export of the Review tab (the same headers; every other column is ignored);
 *   - a canonical lifecycle-decisions CSV (header: sku, status, reason, sheetId; sku required).
 * A formula in a cell that is read is refused (a decision is typed or picked, never computed), and so is U+FFFD in one (a character lost in a conversion;
 * #1123 R1 MED-2: only in the cells that are read, never in a product name). Every other check (unknown SKU, bad status,
 * duplicates, archived with stock, the sheet id against the generation record) belongs to the binding and the transform.
 */
import { CsvFormatError, parseCsvStrict, serializeCsv } from '../csv'
import { DATASETS } from '../spec'
import { BINDING_TAB, DECISION_HEADERS, REVIEW_TAB } from './generation'
import { readXlsx, XlsxError, type ReadSheet } from './xlsx'

export type DecisionFileRead =
  | {
      ok: true
      kind: 'xlsx' | 'review-csv' | 'canonical-csv'
      /** The canonical lifecycle-decisions CSV. For an .xlsx its physical line N is sheet row N, so a disposition names the row the owner sees. */
      canonicalCsv: string
      /** Every distinct non-blank sheet id on a decision row. */
      sheetIds: string[]
      /** The hidden binding tab of an .xlsx (null for a CSV, or when the tab is missing or unreadable: the binding then refuses). */
      bindingTab: { sheetId: string; digest: string } | null
      /** The line (sheet row) of every row that carries a status but no sheet id: the binding refuses the file when there is any (L6). */
      decidedWithoutSheetId: number[]
    }
  | { ok: false; problems: string[] }

const CANONICAL = DATASETS['lifecycle-decisions'].columns

function bad(...problems: string[]): DecisionFileRead {
  return { ok: false, problems }
}

function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

/**
 * U+FFFD in a decision cell (#1123 R1 MED-2): a character already lost in a conversion (a CSV saved in another encoding, a program that could not read it).
 * A SKU or a reason that lost a character is never trusted. Only the four decision columns are checked: a product name (from WooCommerce or Qoblex) may
 * carry U+FFFD, and it is never read back.
 */
function lostCharacters(rows: readonly string[][], lines: readonly number[], labels: readonly string[], where: string): string[] {
  const out: string[] = []
  rows.forEach((row, i) => row.forEach((cell, c) => {
    if (cell.includes('\ufffd')) out.push(`${where} ${lines[i]}: the ${labels[c]} cell holds U+FFFD, a character lost in a conversion: save the sheet again from the original`)
  }))
  return out
}

/** `lines[i]` is the line (sheet row) of `rows[i]`, for the messages. */
function finish(kind: 'xlsx' | 'review-csv' | 'canonical-csv', rows: string[][], lines: readonly number[], bindingTab: { sheetId: string; digest: string } | null): DecisionFileRead {
  const labels = kind === 'canonical-csv' ? CANONICAL : [DECISION_HEADERS.sku, DECISION_HEADERS.status, DECISION_HEADERS.reason, DECISION_HEADERS.sheetId]
  const lost = lostCharacters(rows, lines, labels, kind === 'xlsx' ? 'row' : 'line')
  if (lost.length > 0) return bad(...lost.slice(0, 8), ...(lost.length > 8 ? [`... and ${lost.length - 8} more`] : []))
  const sheetIds = [...new Set(rows.filter((r) => r.some((c) => c.trim() !== '')).map((r) => r[3].trim()).filter((id) => id !== ''))].sort()
  const decidedWithoutSheetId = rows.flatMap((r, i) => (r[1].trim() !== '' && r[3].trim() === '' ? [lines[i]] : []))
  return { ok: true, kind, canonicalCsv: serializeCsv(CANONICAL, rows), sheetIds, bindingTab, decidedWithoutSheetId }
}

function readBindingTab(sheet: ReadSheet | undefined): { sheetId: string; digest: string } | null {
  if (sheet === undefined) return null
  const pairs = new Map<string, string>()
  for (const cells of sheet.rows.values()) {
    const key = cells.get(0)
    const value = cells.get(1)
    if (key && value && !key.formula && !value.formula) pairs.set(key.text.trim(), value.text.trim())
  }
  const sheetId = pairs.get('sheetId')
  const digest = pairs.get('generationDigest')
  return sheetId && digest ? { sheetId, digest } : null
}

function fromXlsx(bytes: Uint8Array): DecisionFileRead {
  let sheets: ReadSheet[]
  try {
    sheets = readXlsx(bytes)
  } catch (error) {
    return bad(`the review sheet cannot be read as an .xlsx workbook: ${error instanceof XlsxError ? error.message : 'unreadable'}`)
  }
  const review = sheets.find((s) => s.name === REVIEW_TAB)
  if (!review) return bad(`the workbook has no "${REVIEW_TAB}" tab: it is not a lifecycle review sheet (or the tab was renamed)`)
  const header = review.rows.get(1)
  if (!header) return bad(`the "${REVIEW_TAB}" tab has no header row`)
  const columns = new Map<string, number>()
  const problems: string[] = []
  for (const [col, cell] of header) {
    const label = cell.text.trim()
    if (!(Object.values(DECISION_HEADERS) as string[]).includes(label)) continue
    if (columns.has(label)) problems.push(`the "${REVIEW_TAB}" tab has two "${label}" columns`)
    columns.set(label, col)
  }
  for (const label of Object.values(DECISION_HEADERS)) if (!columns.has(label)) problems.push(`the "${REVIEW_TAB}" tab has no "${label}" column`)
  if (problems.length > 0) return bad(...problems)
  const order = [DECISION_HEADERS.sku, DECISION_HEADERS.status, DECISION_HEADERS.reason, DECISION_HEADERS.sheetId].map((label) => columns.get(label)!)
  // L2: a loop, never Math.max(...keys) (a spread of a million row numbers overflows the call stack). The reader caps row numbers at the sheet limit.
  let last = 1
  for (const r of review.rows.keys()) if (r > last) last = r
  const rows: string[][] = []
  const lines: number[] = []
  for (let r = 2; r <= last; r++) {
    lines.push(r)
    const cells = review.rows.get(r)
    const out = order.map((col) => {
      const cell = cells?.get(col)
      if (cell?.formula) problems.push(`row ${r} of the "${REVIEW_TAB}" tab: the ${[...columns.entries()].find(([, c]) => c === col)![0]} cell holds a formula; a decision must be typed or picked from the list`)
      return cell?.text ?? ''
    })
    rows.push(out)
  }
  if (problems.length > 0) return bad(...problems.slice(0, 8), ...(problems.length > 8 ? [`... and ${problems.length - 8} more`] : []))
  return finish('xlsx', rows, lines, readBindingTab(sheets.find((s) => s.name === BINDING_TAB)))
}

function fromCsv(bytes: Uint8Array): DecisionFileRead {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return bad('the decisions file is neither an .xlsx workbook nor UTF-8 text (export the Review tab as "CSV UTF-8")')
  }
  let parsed
  try {
    parsed = parseCsvStrict(text)
  } catch (error) {
    return bad(`the decisions CSV is malformed: ${error instanceof CsvFormatError ? error.message : 'unreadable'}`)
  }
  const header = parsed.header
  const reviewLabels = Object.values(DECISION_HEADERS) as string[]
  const isReview = reviewLabels.some((label) => header.includes(label))
  const wanted = isReview ? [DECISION_HEADERS.sku, DECISION_HEADERS.status, DECISION_HEADERS.reason, DECISION_HEADERS.sheetId] : [...CANONICAL]
  const problems: string[] = []
  const index = wanted.map((label) => {
    const hits = header.map((h, i) => (h === label ? i : -1)).filter((i) => i >= 0)
    if (hits.length > 1) problems.push(`the decisions CSV has two "${label}" columns`)
    return hits[0] ?? -1
  })
  if (isReview) {
    for (const [i, label] of wanted.entries()) if (index[i] < 0) problems.push(`the CSV export has no "${label}" column (export the whole ${REVIEW_TAB} tab)`)
  } else {
    const unknown = header.filter((h) => h !== '' && !(CANONICAL as readonly string[]).includes(h))
    if (unknown.length > 0) problems.push(`the decisions CSV is neither an export of the ${REVIEW_TAB} tab (no "${DECISION_HEADERS.sku}" column) nor a canonical lifecycle-decisions file (unknown column(s): ${unknown.slice(0, 5).map((h) => JSON.stringify(h.slice(0, 40))).join(', ')})`)
    else if (index[0] < 0) problems.push('the canonical lifecycle-decisions CSV has no sku column')
  }
  if (problems.length > 0) return bad(...problems)
  const width = parsed.header.length
  const rows: string[][] = []
  const lines: number[] = []
  for (const record of parsed.rows) {
    if (record.cells.length !== width) return bad(`line ${record.line} of the decisions CSV has ${record.cells.length} cell(s) but the header has ${width}`)
    rows.push(index.map((i) => (i < 0 ? '' : record.cells[i])))
    lines.push(record.line)
  }
  return finish(isReview ? 'review-csv' : 'canonical-csv', rows, lines, null)
}

export function readDecisionFile(bytes: Uint8Array): DecisionFileRead {
  return isZip(bytes) ? fromXlsx(bytes) : fromCsv(bytes)
}
