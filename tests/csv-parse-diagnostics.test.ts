import assert from 'node:assert/strict'
import test from 'node:test'

import { csvCommentRowsNotice, csvDiagnosticsErrors, parseCsv, parseCsvDiagnosed, parseCsvValidated } from '../lib/csv.ts'

// o3d-w9tqx: the importers' parser turned a damaged file into quietly different rows. Each case below is the bead's own repro.
test('a row with fewer or more cells than the header is reported with its line, not padded or truncated in silence', () => {
  const { diagnostics } = parseCsvDiagnosed('sku,name\nA,B\nC\nD,E,F\n')
  assert.deepEqual(diagnostics.raggedRows, [
    { line: 3, expected: 2, actual: 1 },
    { line: 4, expected: 2, actual: 3 },
  ])
  assert.equal(csvDiagnosticsErrors(diagnostics).length, 2)
})

test('a well-formed file, including the template guidance row and blank lines, reports nothing', () => {
  const { rows, diagnostics } = parseCsvDiagnosed('sku,name\r\n# REQUIRED,REQUIRED\r\nA,"B, with comma"\r\n\r\nC,"two\nlines"\r\n')
  assert.deepEqual(rows, [{ sku: 'A', name: 'B, with comma' }, { sku: 'C', name: 'two\nlines' }])
  assert.deepEqual(csvDiagnosticsErrors(diagnostics), [])
  assert.equal(diagnostics.commentRowsSkipped, 1)
})

test('a SKU that starts with # is data, not a comment row; "# " guidance rows are still skipped', () => {
  const rows = parseCsvValidated('sku,name\n#X,Y\n# note,ignored\n#123,Z\n')
  assert.deepEqual(rows.map((r) => r.sku), ['#X', '#123'])
})

test('a quote in the middle of an unquoted field is reported with its line', () => {
  const { diagnostics } = parseCsvDiagnosed('sku,name\nA,5" pipe\nB,fine\n')
  assert.deepEqual(diagnostics.strayQuoteRows, [2])
  const ok = parseCsvDiagnosed('sku,name\nA,"5"" pipe"\n')
  assert.deepEqual(ok.diagnostics.strayQuoteRows, [])
  assert.equal(ok.rows[0].name, '5" pipe')
})

test('physical line numbers count lines inside a quoted multi-line field', () => {
  const { diagnostics } = parseCsvDiagnosed('sku,name\nA,"x\ny"\nB\n')
  assert.equal(diagnostics.raggedRows[0].line, 4)
})

// ---- review round 1 -----------------------------------------------------------------------------------------------------------------

test('whitespace before an opening quote opens the quoted field, as it did before diagnosis existed', () => {
  const { rows, diagnostics } = parseCsvDiagnosed('sku,name\nA, "Widget, large"\nB,\t"x"\n')
  assert.deepEqual(rows, [{ sku: 'A', name: 'Widget, large' }, { sku: 'B', name: 'x' }])
  assert.deepEqual(csvDiagnosticsErrors(diagnostics), [])
})

test('a quote after a closing quote, or text after it, is a stray-quote error, not a quoting toggle', () => {
  assert.deepEqual(parseCsvDiagnosed('sku,name\n"a"b"c,d"\n').diagnostics.strayQuoteRows, [2])
  assert.deepEqual(parseCsvDiagnosed('sku,name\nA,"x"y\n').diagnostics.strayQuoteRows, [2])
  assert.deepEqual(parseCsvDiagnosed('sku,name\nA,"x"  \n').diagnostics.strayQuoteRows, [])
})

test('the comment rule looks at the FIRST cell only, and an unexpected skipped row is reported', () => {
  const { rows, diagnostics } = parseCsvDiagnosed('sku,name\n,# 2 bolts\n# REQUIRED,REQUIRED\n# remark,x\nA,B\n')
  assert.deepEqual(rows, [{ sku: '', name: '# 2 bolts' }, { sku: 'A', name: 'B' }])
  assert.equal(diagnostics.commentRowsSkipped, 2)
  assert.deepEqual(diagnostics.unexpectedCommentRows, [4], 'the template row is expected, the "# remark" row is not')
  assert.match(csvCommentRowsNotice(diagnostics) ?? '', /line 4/)
  const exported = parseCsvDiagnosed('sku,name\nA,B\n# IMS export metadata,\n# generatedAt,2026-11-19\n').diagnostics
  assert.equal(exported.commentRowsSkipped, 2)
  assert.equal(csvCommentRowsNotice(exported), null)
})

// parseCsv is the lenient reading the WooCommerce import, Mintsoft bulk product data (LIVE), the products round-trip and first-load rely on.
// `development` is the reference: this is its parseCsv, copied verbatim, and the live one must give identical output.
function developmentParseRows(text: string): string[][] {
  const input = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const rows: string[][] = []
  let fields: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"') {
      if (inQuotes && input[i + 1] === '"') { current += '"'; i++ } else { inQuotes = !inQuotes }
    } else if (ch === ',' && !inQuotes) { fields.push(current); current = '' }
    else if (ch === '\n' && !inQuotes) { fields.push(current); rows.push(fields); fields = []; current = '' }
    else { current += ch }
  }
  fields.push(current)
  rows.push(fields)
  return rows
}
function developmentParseCsv(text: string): Record<string, string>[] {
  const rows = developmentParseRows(text)
  if (rows.length < 2) return []
  const headers = rows[0]
  const results: Record<string, string>[] = []
  for (let i = 1; i < rows.length; i++) {
    const values = rows[i]
    if (values.every((value) => value.trim() === '')) continue
    const firstNonEmpty = values.find((value) => value.trim().length > 0)?.trim() ?? ''
    if (firstNonEmpty.startsWith('#')) continue
    const obj: Record<string, string> = {}
    headers.forEach((h, idx) => { obj[h.trim()] = values[idx]?.trim() ?? '' })
    results.push(obj)
  }
  return results
}

test('parseCsv output is byte-identical to development for #-prefixed rows, stray quotes, ragged rows and whitespace before quotes', () => {
  const samples = [
    'sku,name\n#X,Y\n# note,ignored\n#123,Z\n',
    'sku,name\n,#2 bolts\n,# 2 bolts\nA,B\n',
    'sku,name\r\n# REQUIRED,REQUIRED\r\nA,"B, with comma"\r\n\r\nC,"two\nlines"\r\n',
    'sku,name\nA,5" pipe\nB,fine\n',
    'sku,name\n"a"b"c,d"\nE,F\n',
    'sku,name\nA, "Widget, large"\n',
    'sku,name\nA\nB,C,D\n',
    'sku,name\n#,x\nA,#y\n',
    'sku\n',
    '',
    'a,b\n"x""y",z\r1,2',
  ]
  for (const sample of samples) {
    assert.equal(JSON.stringify(parseCsv(sample)), JSON.stringify(developmentParseCsv(sample)), JSON.stringify(sample))
  }
})
