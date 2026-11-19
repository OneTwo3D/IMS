// ---------------------------------------------------------------------------
// Minimal CSV utilities — no dependencies
// ---------------------------------------------------------------------------

import { Buffer } from 'node:buffer'
import { escapeField } from '@/lib/csv-escape'

export { csvFormulaGuardApplies } from '@/lib/csv-escape'

/**
 * Base64url-encoded JSON object with report-level metadata for API consumers.
 * The CSV body is data rows only by default: standard CSV parsers have no comment
 * syntax and would read trailing `#` rows as records. A caller that asks for
 * `?metadata=1` additionally gets the same metadata as trailing `#` comment rows
 * (see `CSV_METADATA_ROWS_QUERY_PARAM`). Header payloads are capped to avoid
 * proxy/header limits.
 */
export const CSV_METADATA_ROWS_QUERY_PARAM = 'metadata'

export const CSV_EXPORT_METADATA_HEADER = 'X-IMS-Export-Metadata'
export const CSV_EXPORT_METADATA_ENCODING_HEADER = 'X-IMS-Export-Metadata-Encoding'
export const CSV_EXPORT_METADATA_TRUNCATED_HEADER = 'X-IMS-Export-Metadata-Truncated'
export const CSV_EXPORT_METADATA_ENCODING = 'base64url-json'
export const CSV_EXPORT_METADATA_MAX_JSON_BYTES = 4096
/**
 * Report notices (what the report left out or could not plan) for an export whose body stays clean data rows. Carried as a
 * base64url JSON array of strings in this header; the same notices are appended to the body as `#` rows only when the caller
 * opts in (`includeInBody`).
 */
export const CSV_EXPORT_NOTICES_HEADER = 'X-IMS-Export-Notices'
export const CSV_EXPORT_NOTICES_TRUNCATED_HEADER = 'X-IMS-Export-Notices-Truncated'

type CsvExportMetadata = Record<string, unknown>
export type CsvResponseOptions = {
  /** Append the metadata as trailing `#` comment rows. Off unless the request opted in. */
  includeMetadataRows?: boolean
}
type CsvHeaderMetadata = CsvExportMetadata & {
  metadataTruncated?: true
  originalByteLength?: number
}

const ESSENTIAL_METADATA_KEYS = ['generatedAt', 'asOf', 'dateFrom', 'dateTo', 'source', 'groupBy', 'valueReplayReliable']

/** Convert an array of objects to a CSV string */
export function toCsv(rows: Record<string, unknown>[], headers: string[]): string {
  const lines: string[] = [headers.map(escapeField).join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField(row[h])).join(','))
  }
  return lines.join('\r\n')
}

function csvLine(row: Record<string, unknown>, headers: string[]): string {
  return headers.map((header) => escapeField(row[header])).join(',')
}

function safeCsvFilename(filename: string): string {
  return filename.replace(/[\u0000-\u001f\u007f"]/g, '_')
}

function metadataJsonByteLength(metadata: CsvHeaderMetadata): number {
  return Buffer.byteLength(JSON.stringify(metadata), 'utf8')
}

function headerMetadata(metadata: CsvExportMetadata): CsvHeaderMetadata {
  const byteLength = metadataJsonByteLength(metadata)
  if (byteLength <= CSV_EXPORT_METADATA_MAX_JSON_BYTES) return metadata

  const fallback: CsvHeaderMetadata = {
    metadataTruncated: true,
    originalByteLength: byteLength,
  }
  for (const key of ESSENTIAL_METADATA_KEYS) {
    const value = metadata[key]
    if (value !== undefined) fallback[key] = value
  }
  return metadataJsonByteLength(fallback) <= CSV_EXPORT_METADATA_MAX_JSON_BYTES
    ? fallback
    : { metadataTruncated: true, originalByteLength: byteLength }
}

function encodeMetadataHeader(metadata: CsvHeaderMetadata): string {
  return Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url')
}

/** True when the request explicitly opted in to metadata comment rows in the CSV body (`?metadata=1`). */
export function wantsCsvMetadataRows(request: { url: string }): boolean {
  return new URL(request.url).searchParams.get(CSV_METADATA_ROWS_QUERY_PARAM) === '1'
}

function metadataCommentRows(metadata?: CsvExportMetadata, options?: CsvResponseOptions): string {
  if (!options?.includeMetadataRows) return ''
  if (!metadata || Object.keys(metadata).length === 0) return ''
  const rows = ['# IMS export metadata']
  for (const [key, value] of Object.entries(headerMetadata(metadata))) {
    rows.push(csvLine({ key: `# ${key}`, value: valueForMetadataComment(value) }, ['key', 'value']))
  }
  return `\r\n${rows.join('\r\n')}`
}

function valueForMetadataComment(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

export function buildTemplateCsv(
  headers: string[],
  requiredHeaders: string[],
  exampleRows: Array<Record<string, unknown>> = [],
): string {
  const markerRow = headers.map((header, index) => {
    if (index === 0) return '# REQUIRED'
    return requiredHeaders.includes(header) ? 'REQUIRED' : 'OPTIONAL'
  })
  const lines = [headers.map(escapeField).join(','), markerRow.map(escapeField).join(',')]
  for (const row of exampleRows) {
      lines.push(headers.map((header) => escapeField(row[header])).join(','))
  }
  return lines.join('\r\n')
}

/**
 * What a hand-made or damaged file did that `parseCsv` quietly papered over. Line numbers are physical file lines (1-based, the header is line 1),
 * so an operator can find the row in a spreadsheet.
 */
export type CsvDiagnostics = {
  /** A data row whose cell count differs from the header's: `parseCsv` pads it with empty strings or drops its extras, so values land in the wrong columns. */
  raggedRows: Array<{ line: number; expected: number; actual: number }>
  /** A data row with a quote in the middle of an unquoted field (the quote toggled quoting instead of being an error). */
  strayQuoteRows: number[]
  /** Guidance/comment rows skipped, such as the template's "# REQUIRED" row. */
  commentRowsSkipped: number
}

// A guidance row is "# " followed by text ("# REQUIRED", "# IMS export metadata", "# notice"). A bare "#X" or "#123" is DATA: a SKU, supplier
// name or order key may legitimately start with "#" and must not vanish.
function isCommentCell(value: string): boolean {
  return /^#(\s|$)/.test(value)
}

/** Parse CSV text into rows keyed by the header row, and report what the lenient reading hid. */
export function parseCsvDiagnosed(text: string): { rows: Record<string, string>[]; diagnostics: CsvDiagnostics } {
  const { rows: parsedRows, lines, strayQuoteRowIndexes } = parseRows(text)
  const diagnostics: CsvDiagnostics = { raggedRows: [], strayQuoteRows: [], commentRowsSkipped: 0 }
  if (parsedRows.length < 2) return { rows: [], diagnostics }

  const headers = parsedRows[0]
  const results: Record<string, string>[] = []

  for (let i = 1; i < parsedRows.length; i++) {
    const values = parsedRows[i]
    if (values.every((value) => value.trim() === '')) continue
    const firstNonEmpty = values.find((value) => value.trim().length > 0)?.trim() ?? ''
    // Allow templates to carry guidance rows such as "# REQUIRED" without
    // turning them into imported records.
    if (isCommentCell(firstNonEmpty)) {
      diagnostics.commentRowsSkipped++
      continue
    }
    if (values.length !== headers.length) diagnostics.raggedRows.push({ line: lines[i], expected: headers.length, actual: values.length })
    if (strayQuoteRowIndexes.has(i)) diagnostics.strayQuoteRows.push(lines[i])
    const obj: Record<string, string> = {}
    headers.forEach((h, idx) => {
      obj[h.trim()] = values[idx]?.trim() ?? ''
    })
    results.push(obj)
  }

  return { rows: results, diagnostics }
}

/** Operator-facing errors for the problems `parseCsvDiagnosed` found; empty when the file is well formed. */
export function csvDiagnosticsErrors(diagnostics: CsvDiagnostics): string[] {
  const errors: string[] = []
  for (const row of diagnostics.raggedRows.slice(0, 20)) {
    errors.push(`Line ${row.line}: has ${row.actual} cell(s) but the header has ${row.expected} — values would land in the wrong columns`)
  }
  if (diagnostics.raggedRows.length > 20) errors.push(`...and ${diagnostics.raggedRows.length - 20} more row(s) with the wrong number of cells`)
  for (const line of diagnostics.strayQuoteRows.slice(0, 20)) {
    errors.push(`Line ${line}: a quote in the middle of an unquoted field — quote the whole field, or double the quote`)
  }
  return errors
}

/** Parse CSV text into an array of objects keyed by header row. Lenient: use `parseCsvDiagnosed` where a damaged file must be refused. */
export function parseCsv(text: string): Record<string, string>[] {
  return parseCsvDiagnosed(text).rows
}

function parseRows(text: string): { rows: string[][]; lines: number[]; strayQuoteRowIndexes: Set<number> } {
  const input = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rows: string[][] = []
  const lines: number[] = []
  const strayQuoteRowIndexes = new Set<number>()
  let fields: string[] = []
  let current = ''
  let inQuotes = false
  let fieldQuoted = false
  let line = 1
  let rowLine = 1

  const endRow = () => {
    fields.push(current)
    rows.push(fields)
    lines.push(rowLine)
    fields = []
    current = ''
    fieldQuoted = false
  }

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '\n') line++
    if (ch === '"') {
      if (inQuotes && input[i + 1] === '"') {
        current += '"'
        i++
      } else if (!inQuotes && current !== '' && !fieldQuoted) {
        // A quote in the middle of an unquoted field.
        strayQuoteRowIndexes.add(rows.length)
        current += ch
      } else {
        if (!inQuotes) fieldQuoted = true
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current)
      current = ''
      fieldQuoted = false
    } else if (ch === '\n' && !inQuotes) {
      endRow()
      rowLine = line
    } else {
      current += ch
    }
  }
  endRow()
  return { rows, lines, strayQuoteRowIndexes }
}

function csvHeaders(filename: string, metadata?: CsvExportMetadata): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${safeCsvFilename(filename)}"`,
  }
  if (metadata && Object.keys(metadata).length > 0) {
    const encodedMetadata = headerMetadata(metadata)
    headers[CSV_EXPORT_METADATA_HEADER] = encodeMetadataHeader(encodedMetadata)
    headers[CSV_EXPORT_METADATA_ENCODING_HEADER] = CSV_EXPORT_METADATA_ENCODING
    headers['Access-Control-Expose-Headers'] = [
      'Content-Disposition',
      CSV_EXPORT_METADATA_HEADER,
      CSV_EXPORT_METADATA_ENCODING_HEADER,
      CSV_EXPORT_METADATA_TRUNCATED_HEADER,
    ].join(', ')
    if (encodedMetadata.metadataTruncated) headers[CSV_EXPORT_METADATA_TRUNCATED_HEADER] = 'true'
  }
  return headers
}

/** Build a Response that triggers a file download */
export function csvResponse(csv: string, filename: string, metadata?: CsvExportMetadata, options?: CsvResponseOptions): Response {
  return new Response(`${csv}${metadataCommentRows(metadata, options)}`, {
    headers: csvHeaders(filename, metadata),
  })
}

function noticeCommentRows(notices: string[]): string {
  if (notices.length === 0) return ''
  const rows = ['# IMS export notices', ...notices.map((notice) => csvLine({ key: '# notice', value: notice }, ['key', 'value']))]
  return `\r\n${rows.join('\r\n')}`
}

/**
 * A CSV download for a report that has notices. The body is the data rows only, unless `includeInBody` is set, in which
 * every notice follows the data as a `# notice` row, uncapped. The notices always travel in the {@link CSV_EXPORT_NOTICES_HEADER}
 * response header, dropping trailing ones (and flagging {@link CSV_EXPORT_NOTICES_TRUNCATED_HEADER}) to stay inside the header cap.
 */
export function csvResponseWithNotices(csv: string, filename: string, notices: string[], options: { includeInBody?: boolean } = {}): Response {
  // The body rows come from the COMPLETE list: only the header payload below is capped.
  const response = csvResponse(csv, filename)
  const body = options.includeInBody ? noticeCommentRows(notices) : ''
  const out = body ? new Response(`${csv}${body}`, { headers: response.headers }) : response
  if (notices.length === 0) return out
  let kept = notices
  while (kept.length > 1 && Buffer.byteLength(JSON.stringify(kept), 'utf8') > CSV_EXPORT_METADATA_MAX_JSON_BYTES) {
    kept = kept.slice(0, -1)
  }
  let truncated = kept.length < notices.length
  if (Buffer.byteLength(JSON.stringify(kept), 'utf8') > CSV_EXPORT_METADATA_MAX_JSON_BYTES) {
    kept = [kept[0].slice(0, 1000)]
    truncated = true
  }
  out.headers.set(CSV_EXPORT_NOTICES_HEADER, Buffer.from(JSON.stringify(kept), 'utf8').toString('base64url'))
  out.headers.set('Access-Control-Expose-Headers', [out.headers.get('Access-Control-Expose-Headers'), CSV_EXPORT_NOTICES_HEADER, CSV_EXPORT_NOTICES_TRUNCATED_HEADER].filter(Boolean).join(', '))
  if (truncated) out.headers.set(CSV_EXPORT_NOTICES_TRUNCATED_HEADER, 'true')
  return out
}

/**
 * Build a streamed CSV download response from already-materialized rows.
 * This chunks the wire response but does not make the caller's memory profile O(1).
 */
export function csvBufferedStreamResponse(rows: Iterable<Record<string, unknown>>, headers: string[], filename: string, metadata?: CsvExportMetadata, options?: CsvResponseOptions): Response {
  const encoder = new TextEncoder()
  const iterator = rows[Symbol.iterator]()
  let headerSent = false

  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!headerSent) {
        controller.enqueue(encoder.encode(headers.map(escapeField).join(',')))
        headerSent = true
      }

      let pushed = 0
      while (pushed < 100) {
        const next = iterator.next()
        if (next.done) {
          const comments = metadataCommentRows(metadata, options)
          if (comments) controller.enqueue(encoder.encode(comments))
          controller.close()
          return
        }
        controller.enqueue(encoder.encode(`\r\n${csvLine(next.value, headers)}`))
        pushed += 1
      }
    },
  })

  return new Response(stream, {
    headers: csvHeaders(filename, metadata),
  })
}

/** `csvResponse` for a request: metadata comment rows only when the request carries `?metadata=1`. */
export function csvResponseFor(request: { url: string }, csv: string, filename: string, metadata?: CsvExportMetadata): Response {
  return csvResponse(csv, filename, metadata, { includeMetadataRows: wantsCsvMetadataRows(request) })
}

/** `csvBufferedStreamResponse` for a request: metadata comment rows only when the request carries `?metadata=1`. */
export function csvBufferedStreamResponseFor(
  request: { url: string },
  rows: Iterable<Record<string, unknown>>,
  headers: string[],
  filename: string,
  metadata?: CsvExportMetadata,
): Response {
  return csvBufferedStreamResponse(rows, headers, filename, metadata, { includeMetadataRows: wantsCsvMetadataRows(request) })
}
