// ---------------------------------------------------------------------------
// Minimal CSV utilities — no dependencies
// ---------------------------------------------------------------------------

// Characters that trigger formula evaluation in Excel / LibreOffice / Google Sheets
// when they appear at the start of a cell. We neutralise by prefixing with `'`.
const FORMULA_PREFIX = /^[=+\-@\t\r]/
const NUMERIC_LITERAL = /^-?\d+(?:\.\d+)?$/

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
  const lines: string[] = [headers.join(',')]
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField(row[h])).join(','))
  }
  return lines.join('\r\n')
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
  const lines = [headers.join(','), markerRow.map(escapeField).join(',')]
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

/** Build a Response that triggers a file download */
export function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
