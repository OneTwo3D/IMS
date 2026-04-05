// ---------------------------------------------------------------------------
// Minimal CSV utilities — no dependencies
// ---------------------------------------------------------------------------

/** Escape a single value for CSV output */
function escapeField(value: unknown): string {
  if (value === null || value === undefined) return ''
  const str = String(value)
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

/** Parse CSV text into an array of objects keyed by header row */
export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (lines.length < 2) return []

  const headers = parseRow(lines[0])
  const results: Record<string, string>[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const values = parseRow(line)
    const obj: Record<string, string> = {}
    headers.forEach((h, idx) => {
      obj[h.trim()] = values[idx]?.trim() ?? ''
    })
    results.push(obj)
  }

  return results
}

function parseRow(line: string): string[] {
  const fields: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
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
