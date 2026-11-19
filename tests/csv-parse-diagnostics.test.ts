import assert from 'node:assert/strict'
import test from 'node:test'

import { csvDiagnosticsErrors, parseCsv, parseCsvDiagnosed } from '../lib/csv.ts'

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
  const rows = parseCsv('sku,name\n#X,Y\n# note,ignored\n#123,Z\n')
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
