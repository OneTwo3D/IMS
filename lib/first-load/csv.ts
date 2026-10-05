/**
 * Strict CSV reading and plain CSV writing for the first-load tools.
 *
 * WHY NOT `lib/csv.ts`. Its `parseCsv` is written for forgiving operator uploads: it pads a short row with empty strings
 * and drops the extra cells of a long one, ignores any row whose first cell starts with "#", and accepts a quote in the
 * middle of a field. Each of those turns a damaged input into a quietly different row. (A leading BOM is harmless there:
 * its header `trim()` removes it.) This reader rejects them instead, and reports the physical line of every record.
 *
 * The WRITER emits exactly what the importers' own parser reads back: RFC 4180 quoting, CRLF, no BOM, and none of
 * `lib/csv.ts`'s formula-prefix rewriting (the importers do not strip it, so it would alter the data).
 */

export class CsvFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CsvFormatError'
  }
}

export interface CsvRecord {
  /** 1-based physical line on which the record starts (the header is normally line 1). */
  line: number
  cells: string[]
}

export interface ParsedCsv {
  header: string[]
  rows: CsvRecord[]
  /** Records whose cells are all empty (a blank line, or only delimiters). Never counted as data rows. */
  blankRows: number
  hadBom: boolean
}

export function parseCsvStrict(text: string, delimiter = ','): ParsedCsv {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
    throw new CsvFormatError(`unsupported delimiter ${JSON.stringify(delimiter)}`)
  }
  let hadBom = false
  if (text.charCodeAt(0) === 0xfeff) {
    hadBom = true
    text = text.slice(1)
  }

  const records: CsvRecord[] = []
  let cells: string[] = []
  let cell = ''
  let inQuotes = false
  let quoteOpenedAtLine = 0
  let afterClosingQuote = false
  let line = 1
  let recordLine = 1
  let fieldStarted = false

  const endCell = () => {
    cells.push(cell)
    cell = ''
    fieldStarted = false
    afterClosingQuote = false
  }
  const endRecord = () => {
    endCell()
    records.push({ line: recordLine, cells })
    cells = []
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
          afterClosingQuote = true
        }
      } else {
        if (ch === '\n') line++
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      if (fieldStarted || afterClosingQuote) {
        throw new CsvFormatError(`line ${line}: a quote in the middle of a field (quote the whole field and double any inner quote)`)
      }
      inQuotes = true
      quoteOpenedAtLine = line
      fieldStarted = true
      continue
    }
    if (ch === delimiter) {
      endCell()
      continue
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      endRecord()
      line++
      recordLine = line
      continue
    }
    if (afterClosingQuote) {
      throw new CsvFormatError(`line ${line}: text after the closing quote of a field`)
    }
    cell += ch
    fieldStarted = true
  }
  if (inQuotes) throw new CsvFormatError(`line ${quoteOpenedAtLine}: unterminated quoted field`)
  if (fieldStarted || afterClosingQuote || cell.length > 0 || cells.length > 0) endRecord()

  let blankRows = 0
  const data: CsvRecord[] = []
  let header: string[] | null = null
  for (const record of records) {
    if (record.cells.every((value) => value.trim() === '')) {
      blankRows++
      continue
    }
    if (header === null) {
      header = record.cells.map((value) => value.trim())
      continue
    }
    data.push(record)
  }
  if (header === null) throw new CsvFormatError('the file has no header row')
  return { header, rows: data, blankRows, hadBom }
}

function needsQuoting(value: string): boolean {
  return /[",\r\n]/.test(value) || value !== value.trim()
}

function escapeCell(value: string): string {
  return needsQuoting(value) ? `"${value.replace(/"/g, '""')}"` : value
}

export function serializeCsvLine(cells: readonly string[]): string {
  return cells.map(escapeCell).join(',')
}

const CRLF = '\r\n'

/** CRLF line endings and a final CRLF. Deterministic: depends only on its arguments. */
export function serializeCsv(header: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  return [...[header, ...rows].map((cells) => serializeCsvLine(cells)), ''].join(CRLF)
}

/**
 * The importers' parser (`parseCsv` in lib/csv.ts) silently skips a row whose first NON-EMPTY cell starts with "#".
 * Returns the offending cell, or null when the row would be read.
 */
export function importerSilentlySkipsRow(cells: readonly string[]): string | null {
  const first = cells.find((value) => value.trim().length > 0)
  return first !== undefined && first.trim().startsWith('#') ? first : null
}
