// ---------------------------------------------------------------------------
// Minimal CSV utilities — no dependencies
// ---------------------------------------------------------------------------

import { Buffer } from 'node:buffer'

// Characters that trigger formula evaluation in Excel / LibreOffice / Google Sheets
// when they appear at the start of a cell. We neutralise by prefixing with `'`.
const FORMULA_PREFIX = /^[=+\-@\t\r]/
const NUMERIC_LITERAL = /^-?\d+(?:\.\d+)?$/

/**
 * Base64url-encoded JSON object with report-level metadata for API consumers.
 * The CSV body also includes `#` comment rows with the same metadata for
 * operator downloads. Header payloads are capped to avoid proxy/header limits.
 */
export const CSV_EXPORT_METADATA_HEADER = 'X-IMS-Export-Metadata'
export const CSV_EXPORT_METADATA_ENCODING_HEADER = 'X-IMS-Export-Metadata-Encoding'
export const CSV_EXPORT_METADATA_TRUNCATED_HEADER = 'X-IMS-Export-Metadata-Truncated'
export const CSV_EXPORT_METADATA_ENCODING = 'base64url-json'
export const CSV_EXPORT_METADATA_MAX_JSON_BYTES = 4096

type CsvExportMetadata = Record<string, unknown>
type CsvHeaderMetadata = CsvExportMetadata & {
  metadataTruncated?: true
  originalByteLength?: number
}

const ESSENTIAL_METADATA_KEYS = ['generatedAt', 'asOf', 'dateFrom', 'dateTo', 'source', 'groupBy', 'valueReplayReliable']

/** Escape a single value for CSV output */
function escapeField(value: unknown): string {
  if (value === null || value === undefined) return ''
  let str = String(value)
  // CSV injection mitigation — see OWASP "Formula Injection".
  // Preserve plain numeric literals so exported quantity/currency fields
  // remain re-importable without carrying a leading apostrophe.
  if (FORMULA_PREFIX.test(str) && !NUMERIC_LITERAL.test(str)) str = "'" + str
  // Quote if contains comma, quote, newline
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

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

function metadataCommentRows(metadata?: CsvExportMetadata): string {
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

/** Parse CSV text into an array of objects keyed by header row */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseRows(text)
  if (rows.length < 2) return []

  const headers = rows[0]
  const results: Record<string, string>[] = []

  for (let i = 1; i < rows.length; i++) {
    const values = rows[i]
    if (values.every((value) => value.trim() === '')) continue
    const firstNonEmpty = values.find((value) => value.trim().length > 0)?.trim() ?? ''
    // Allow templates to carry guidance rows such as "# REQUIRED" without
    // turning them into imported records.
    if (firstNonEmpty.startsWith('#')) continue
    const obj: Record<string, string> = {}
    headers.forEach((h, idx) => {
      obj[h.trim()] = values[idx]?.trim() ?? ''
    })
    results.push(obj)
  }

  return results
}

function parseRows(text: string): string[][] {
  const input = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rows: string[][] = []
  let fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"') {
      if (inQuotes && input[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current)
      current = ''
    } else if (ch === '\n' && !inQuotes) {
      fields.push(current)
      rows.push(fields)
      fields = []
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  rows.push(fields)
  return rows
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
export function csvResponse(csv: string, filename: string, metadata?: CsvExportMetadata): Response {
  return new Response(`${csv}${metadataCommentRows(metadata)}`, {
    headers: csvHeaders(filename, metadata),
  })
}

/**
 * Build a streamed CSV download response from already-materialized rows.
 * This chunks the wire response but does not make the caller's memory profile O(1).
 */
export function csvBufferedStreamResponse(rows: Iterable<Record<string, unknown>>, headers: string[], filename: string, metadata?: CsvExportMetadata): Response {
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
          const comments = metadataCommentRows(metadata)
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
